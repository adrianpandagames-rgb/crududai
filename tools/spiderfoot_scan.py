# Runs SpiderFoot's command line (sf.py) with the target type chosen in crududai instead of the one sf.py guesses:
# sf.py reads IPv6 addresses, ASNs and Bitcoin addresses as usernames, and "juan.perez" as a domain.
# Usage: <spiderfoot venv python> spiderfoot_scan.py <sf.py arguments>
# Environment: SPIDERFOOT_DIR (the SpiderFoot checkout) and SPIDERFOOT_TARGET_TYPE (e.g. USERNAME, IPV6_ADDRESS).
import os
import runpy
import sys

sf_dir = os.environ.get('SPIDERFOOT_DIR', '/opt/spiderfoot')
target_type = os.environ.get('SPIDERFOOT_TARGET_TYPE')
sys.path.insert(0, sf_dir)

from spiderfoot import SpiderFootHelpers  # noqa: E402

if target_type:
    SpiderFootHelpers.targetTypeFromString = staticmethod(lambda target: target_type)

sys.argv = [os.path.join(sf_dir, 'sf.py'), *sys.argv[1:]]
runpy.run_path(sys.argv[0], run_name='__main__')
