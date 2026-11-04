import datetime
from contextlib import closing
import errno
import fcntl
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tarfile

import psycopg

_DATA_HOME = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local' / 'share')))
_KB_ROOT = Path(os.environ.get('HIS_KB_ROOT', str(_DATA_HOME / 'hardviser' / 'knowledge-base')))
DATA_ROOT = Path(os.environ.get('HIS_APP_DATA_ROOT', str(_DATA_HOME / 'hardviser' / 'app-data')))
FILES_DIR = DATA_ROOT / 'files'
BACKUP_DIR = DATA_ROOT / 'backups'
PG_DUMP = os.environ.get('HIS_APP_BACKUP_PG_DUMP') or shutil.which('pg_dump')
AGE = os.environ.get('HIS_APP_BACKUP_AGE') or shutil.which('age')
RCLONE = os.environ.get('HIS_APP_BACKUP_RCLONE') or shutil.which('rclone')
DB_HOST = os.environ.get('HIS_APP_BACKUP_DB_HOST') or os.environ.get('HIS_APP_DB_HOST', '127.0.0.1')
DB_PORT = int(os.environ.get('HIS_APP_BACKUP_DB_PORT') or os.environ.get('HIS_APP_DB_PORT', '5432'))
DB_NAME = os.environ.get('HIS_APP_BACKUP_DB_NAME') or os.environ.get('HIS_APP_DB_NAME', 'hardviser_app')
DB_USER = os.environ.get('HIS_APP_BACKUP_DB_USER') or os.environ.get('HIS_APP_DB_USER', 'app_runtime')
CONFIG_FILE = Path(os.environ.get('HIS_APP_BACKUP_CONFIG_FILE', '/etc/hardviser/backend.env'))
RCLONE_DESTINATION = os.environ.get('HIS_APP_BACKUP_RCLONE_DESTINATION', '').strip().rstrip('/')
STATE_DB = Path(os.environ.get('HIS_KB_PUBLIC_CHAT_STATE_DB', str(
    _KB_ROOT / 'runtime' / 'public-chat' / 'state.sqlite3',
)))
SHA256 = re.compile(r'^[a-f0-9]{64}$')


def fail(message):
    raise RuntimeError(message)


def secure_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        fail('App backup directory has an unexpected owner or type.')
    path.chmod(0o700)


def secure_file(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        fail('App backup input has unexpected ownership or permissions.')


def snapshot_sqlite(destination):
    secure_file(STATE_DB)
    source_uri = STATE_DB.resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(source_uri, uri=True, timeout=10)) as source:
        with closing(sqlite3.connect(destination, timeout=10)) as backup:
            source.backup(backup)
    os.chmod(destination, 0o600)


def snapshot_database_and_files(stage):
    stage_files = stage / 'files'
    stage_files.mkdir(mode=0o700)
    lock = psycopg.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER,
        dbname=DB_NAME, connect_timeout=10,
    )
    snapshot = None
    try:
        # Keep file references stable until the snapshot's blobs are linked.
        lock.execute("SET lock_timeout = '5min'")
        lock.execute('LOCK TABLE public.files IN SHARE MODE')
        snapshot = psycopg.connect(
            host=DB_HOST, port=DB_PORT, user=DB_USER,
            dbname=DB_NAME, connect_timeout=10,
        )
        snapshot.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        snapshot_id = snapshot.execute('SELECT pg_export_snapshot()').fetchone()[0]
        rows = snapshot.execute(
            "SELECT DISTINCT sha256 FROM public.files "
            "WHERE deleted_at IS NULL AND status <> 'failed' ORDER BY sha256"
        ).fetchall()

        for (digest,) in rows:
            if not isinstance(digest, str) or not SHA256.fullmatch(digest):
                fail('App database contains an invalid file digest.')
            source_path = FILES_DIR / digest[:2] / digest
            secure_file(source_path)
            shard = stage_files / digest[:2]
            shard.mkdir(mode=0o700, exist_ok=True)
            target_path = shard / digest
            try:
                os.link(source_path, target_path, follow_symlinks=False)
            except OSError as error:
                if error.errno != errno.EXDEV:
                    raise
                shutil.copyfile(source_path, target_path, follow_symlinks=False)
                os.chmod(target_path, 0o600)

        # Hard links retain the blob bytes; the exported snapshot retains the rows.
        # Release the write-blocking lock before dumping the remaining database.
        lock.rollback()

        dump_path = stage / 'hardviser-app.dump'
        subprocess.run([
            str(PG_DUMP), '-Fc', '-h', DB_HOST, '-p', str(DB_PORT),
            '-U', DB_USER, '-d', DB_NAME, '--snapshot', snapshot_id,
            '-f', str(dump_path),
        ], check=True)

        return len(rows)
    finally:
        if snapshot is not None:
            snapshot.rollback()
            snapshot.close()
        lock.rollback()
        lock.close()


def snapshot_runtime_config(stage):
    destination = stage / 'runtime-config'
    destination.mkdir(mode=0o700)
    secure_file(CONFIG_FILE)
    target = destination / 'backend.env'
    shutil.copyfile(CONFIG_FILE, target, follow_symlinks=False)
    target.chmod(0o600)

def make_bundle(stage, bundle_tmp):
    def numeric_owner(member):
        member.uname = ''
        member.gname = ''
        return member

    with tarfile.open(bundle_tmp, mode='w:gz', format=tarfile.PAX_FORMAT) as archive:
        for name in ('files', 'hardviser-app.dump', 'runtime-config', 'state.sqlite3'):
            archive.add(stage / name, arcname=name, recursive=True, filter=numeric_owner)
    with bundle_tmp.open('rb+') as archive:
        os.fsync(archive.fileno())


def upload_offsite(bundle_path):
    recipient = os.environ.get('HIS_APP_BACKUP_AGE_RECIPIENT', '').strip()
    if not recipient or '\n' in recipient or '\r' in recipient:
        raise SystemExit(
            'Offsite app backup refused: set an explicit HIS_APP_BACKUP_AGE_RECIPIENT; '
            'the local snapshot is retained.'
        )
    if not RCLONE_DESTINATION or '\n' in RCLONE_DESTINATION or '\r' in RCLONE_DESTINATION:
        raise SystemExit(
            'Offsite app backup refused: set an explicit HIS_APP_BACKUP_RCLONE_DESTINATION; '
            'the local snapshot is retained.'
        )
    if not AGE or not Path(AGE).is_file() or not os.access(AGE, os.X_OK):
        fail('age encryption tool is unavailable; local snapshot is retained.')
    if not RCLONE or not Path(RCLONE).is_file() or not os.access(RCLONE, os.X_OK):
        fail('rclone upload tool is unavailable; local snapshot is retained.')
    credentials_dir = os.environ.get('CREDENTIALS_DIRECTORY')
    if not credentials_dir:
        fail('rclone credential was not provided; local snapshot is retained.')
    rclone_config = Path(credentials_dir) / 'rclone.conf'
    try:
        config_info = rclone_config.lstat()
    except FileNotFoundError:
        fail('rclone credential was not provided; local snapshot is retained.')
    if not stat.S_ISREG(config_info.st_mode) or not os.access(rclone_config, os.R_OK):
        fail('rclone credential is unavailable; local snapshot is retained.')

    fd, encrypted_name = tempfile.mkstemp(
        prefix='.hardviser-app-encrypted.', suffix='.age', dir=BACKUP_DIR,
    )
    encrypted_path = Path(encrypted_name)
    try:
        with os.fdopen(fd, 'wb') as encrypted_output:
            subprocess.run([
                str(AGE), '-r', recipient, str(bundle_path),
            ], check=True, stdout=encrypted_output)
            encrypted_output.flush()
            os.fsync(encrypted_output.fileno())
        if encrypted_path.stat().st_size == 0:
            fail('Encrypted app bundle is empty; local snapshot is retained.')
        rclone_env = os.environ.copy()
        rclone_env['RCLONE_CONFIG'] = str(rclone_config)
        remote_path = f'{RCLONE_DESTINATION}/{bundle_path.name}.age'
        subprocess.run([
            str(RCLONE), 'copyto', str(encrypted_path), remote_path,
            '--s3-no-check-bucket',
        ], check=True, env=rclone_env)
        print(f'Uploaded encrypted app snapshot {bundle_path.name}.age.', flush=True)
    finally:
        encrypted_path.unlink(missing_ok=True)


def prune_local_backups():
    cutoff = datetime.datetime.now(datetime.timezone.utc).timestamp() - 6 * 24 * 60 * 60
    for path in BACKUP_DIR.iterdir():
        if not path.name.startswith('hardviser-app-') or not path.name.endswith(('.dump', '.tar.gz')):
            continue
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(info.st_mode) and info.st_mtime < cutoff:
            path.unlink()


def main():
    os.umask(0o077)
    secure_dir(DATA_ROOT)
    secure_dir(FILES_DIR)
    secure_dir(BACKUP_DIR)
    if not PG_DUMP or not Path(PG_DUMP).is_file() or not os.access(PG_DUMP, os.X_OK):
        fail('PostgreSQL dump tool is unavailable.')

    lock_path = BACKUP_DIR / '.hardviser-app-backup.lock'
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        lock_info = os.fstat(fd)
        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.geteuid():
            fail('App backup lock has an unexpected owner or type.')
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return

        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        final_path = BACKUP_DIR / f'hardviser-app-{stamp}.tar.gz'
        with tempfile.TemporaryDirectory(prefix='.hardviser-app-stage.', dir=BACKUP_DIR) as stage_name:
            stage = Path(stage_name)
            files_count = snapshot_database_and_files(stage)
            snapshot_sqlite(stage / 'state.sqlite3')
            snapshot_runtime_config(stage)
            fd_tmp, tmp_name = tempfile.mkstemp(prefix='.hardviser-app-bundle.', dir=BACKUP_DIR)
            os.close(fd_tmp)
            bundle_tmp = Path(tmp_name)
            try:
                make_bundle(stage, bundle_tmp)
                if bundle_tmp.stat().st_size == 0:
                    fail('App backup archive is empty.')
                os.link(bundle_tmp, final_path, follow_symlinks=False)
                bundle_tmp.unlink()
                dir_fd = os.open(BACKUP_DIR, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            finally:
                bundle_tmp.unlink(missing_ok=True)
        prune_local_backups()
        print(f'Created {final_path.name} ({final_path.stat().st_size} bytes, {files_count} immutable files).', flush=True)
        upload_offsite(final_path)
    finally:
        os.close(fd)


if __name__ == '__main__':
    main()
