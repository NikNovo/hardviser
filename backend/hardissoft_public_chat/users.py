"""Manage local chat users without exposing passwords on the command line."""
import argparse
import getpass
import os
import pwd
import sys

from . import adminstore, appstore


def _password(args):
    if args.password_stdin:
        first = sys.stdin.readline()
        if first == '':
            raise appstore.Invalid('password')
        password = first.rstrip('\r\n')
    else:
        password = getpass.getpass('Password: ')
        confirmation = getpass.getpass('Confirm password: ')
        if password != confirmation:
            raise appstore.Invalid('password_mismatch')
    if not password:
        raise appstore.Invalid('password')
    return password


def _parser():
    parser = argparse.ArgumentParser(prog='python -m hardissoft_public_chat.users')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('create', 'passwd'):
        command = commands.add_parser(name)
        command.add_argument('login')
        command.add_argument('--password-stdin', action='store_true')

    disable = commands.add_parser('disable')
    disable.add_argument('login')
    disable.add_argument('--reason', required=True)

    bootstrap = commands.add_parser('bootstrap-admin')
    bootstrap.add_argument('user_id')
    bootstrap.add_argument('--reason', required=True)

    commands.add_parser('list')
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    conn = appstore.connect()
    try:
        if args.command == 'create':
            user = appstore.create_user(conn, args.login, _password(args))
            conn.commit()
            print('Created user %s' % user['login'])
        elif args.command == 'passwd':
            users = {user['login']: user for user in appstore.list_users(conn)}
            user = users.get(args.login.strip().lower())
            if user is None:
                raise appstore.NotFound()
            appstore.set_password(conn, user['id'], _password(args))
            conn.commit()
            print('Updated password for %s' % user['login'])
        elif args.command == 'disable':
            users = {user['login']: user for user in appstore.list_users(conn)}
            user = users.get(args.login.strip().lower())
            if user is None:
                raise appstore.NotFound()
            adminstore.operator_disable(
                conn, user['id'], args.reason, pwd.getpwuid(os.geteuid()).pw_name)
            conn.commit()
            print('Disabled user %s' % user['login'])
        elif args.command == 'bootstrap-admin':
            user = adminstore.bootstrap_admin(
                conn, args.user_id, args.reason, pwd.getpwuid(os.geteuid()).pw_name)
            conn.commit()
            print('Granted admin role to %s' % user['login'])
        else:
            for user in appstore.list_users(conn):
                suffix = ' (disabled)' if user['disabled_at'] is not None else ''
                print(user['login'] + suffix)
            conn.rollback()
        return 0
    except (appstore.Invalid, appstore.NotFound, adminstore.AdminError) as exc:
        conn.rollback()
        print('User operation failed: %s' % exc, file=sys.stderr)
        return 2
    except Exception:
        conn.rollback()
        print('User operation failed.', file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == '__main__':
    raise SystemExit(main())
