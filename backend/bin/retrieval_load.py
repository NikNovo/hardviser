"""Retrieval-only load test: concurrent technical-turn searches without any MUSE call.

Run only against an isolated, authorized staging database and knowledge-base root.
Set PYTHONPATH to backend/vendor/knowledge-base/src:backend and use staging-only
configuration; never point this command at production.

  python backend/bin/retrieval_load.py --concurrency 5,10 --per-turn 2

Each tier starts N simulated turns at once; every turn calls retrieval.retrieve().
The command prints one row per tier and exits 1 if the error rate exceeds its limit.
"""
import argparse
import collections
import json
import os
import sys
import threading
import time

from hardissoft_public_chat import fast_index, retrieval

QUERIES = [
    'deploying reliable production service', 'load testing production service reliability',
    'power supply design review checklist', 'firmware update rollback strategy', 'buck converter inductor selection',
    'PCB stackup for high speed signals', 'ESD protection on USB lines', 'thermal design of enclosure',
    'injection molding draft angle', 'CNC machining tolerances aluminum', 'battery management system balancing',
    'BLE antenna placement', 'STM32 low power modes', 'EMC pre-compliance testing', 'connector selection for vibration',
    'датчик температуры калибровка', 'разводка печатной платы земля', 'выбор микроконтроллера для IoT',
    'source code review process', 'manufacturing test fixture design', 'LiPo charging circuit',
    'motor driver H-bridge', 'CAN bus termination', 'RS-485 grounding', 'ADC noise reduction',
    'OTA update security', 'product certification CE marking', 'BOM cost reduction', 'DFM guidelines', 'IP67 sealing gasket',
]


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    return round(values[min(len(values) - 1, max(0, int(fraction * len(values) + 0.999999) - 1))], 2)


class Sampler(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.stop = threading.Event()
        self.peak = {'load1': 0.0, 'rss_mb': 0, 'pg_connections': 0}

    def run(self):
        conn = retrieval._open_connection()
        conn.autocommit = True
        try:
            while not self.stop.is_set():
                with open('/proc/loadavg') as stream:
                    self.peak['load1'] = max(self.peak['load1'], float(stream.read().split()[0]))
                with open('/proc/self/status') as stream:
                    rss = next(int(line.split()[1]) for line in stream if line.startswith('VmRSS'))
                self.peak['rss_mb'] = max(self.peak['rss_mb'], rss // 1024)
                count = conn.execute('SELECT count(*) AS n FROM pg_stat_activity').fetchone()['n']
                self.peak['pg_connections'] = max(self.peak['pg_connections'], count)
                self.stop.wait(1)
        finally:
            conn.close()


def run_tier(concurrency, per_turn, budget, queries):
    barrier = threading.Barrier(concurrency)
    outcomes = []
    lock = threading.Lock()

    def turn(number):
        selected = [queries[(number * per_turn + offset) % len(queries)] for offset in range(per_turn)]
        barrier.wait()
        started = time.monotonic()
        try:
            evidence = retrieval.retrieve(selected, deadline=started + budget)
            outcome = ('ok', time.monotonic() - started, len(evidence))
        except Exception as error:
            outcome = (type(error).__name__, time.monotonic() - started, 0)
        with lock:
            outcomes.append(outcome)

    sampler = Sampler()
    sampler.start()
    started = time.monotonic()
    threads = [threading.Thread(target=turn, args=(number,)) for number in range(concurrency)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    wall = time.monotonic() - started
    sampler.stop.set()
    sampler.join()
    ok = [elapsed for kind, elapsed, _ in outcomes if kind == 'ok']
    errors = collections.Counter(kind for kind, _, _ in outcomes if kind != 'ok')
    return {
        'turns': concurrency, 'ok': len(ok), 'errors': dict(errors),
        'p50_s': percentile(ok, 0.5), 'p95_s': percentile(ok, 0.95), 'max_s': percentile(ok, 1.0),
        'turns_per_min': round(len(ok) / wall * 60, 1), 'wall_s': round(wall, 1),
        'empty_evidence': sum(1 for kind, _, count in outcomes if kind == 'ok' and count == 0),
        **sampler.peak,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--concurrency', default='10,50,100,200')
    parser.add_argument('--per-turn', type=int, choices=(1, 2), default=2)
    parser.add_argument('--budget-seconds', type=float, default=35.0)
    parser.add_argument('--pause', type=float, default=10.0)
    parser.add_argument('--queries-file', help='one query per line')
    parser.add_argument('--max-error-rate', type=float, default=0.01)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    queries = QUERIES
    if args.queries_file:
        with open(args.queries_file, encoding='utf-8') as stream:
            queries = [line.strip() for line in stream if line.strip()]
    tiers = [int(value) for value in args.concurrency.split(',')]

    started = time.monotonic()
    retrieval.warm_up()
    fast_index.build_now(retrieval.context())
    print('index', 'fast' if fast_index.ready() else 'slow-path only', 'ready in', round(time.monotonic() - started, 1), 's',
          file=sys.stderr, flush=True)

    failed = False
    for position, concurrency in enumerate(tiers):
        if position:
            time.sleep(args.pause)
        row = run_tier(concurrency, args.per_turn, args.budget_seconds, queries)
        error_rate = 1 - row['ok'] / row['turns']
        failed = failed or error_rate > args.max_error_rate
        print(json.dumps(row, ensure_ascii=False) if args.json else
              '{turns:>4} turns  ok {ok:>4}  errors {errors}  p50 {p50_s}s  p95 {p95_s}s  max {max_s}s  '
              '{turns_per_min}/min  load1 {load1}  rss {rss_mb}MB  pg {pg_connections}'.format(**row), flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
    raise SystemExit(main())
