"""Smoke-test a generated PHP bundle without a database or real supplier calls."""
from pathlib import Path
import argparse
import json
import os
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

def verify(bundle: Path):
    bundle = bundle.resolve()
    assert (bundle / 'server-manifest.json').is_file(), 'Build the server bundle first'
    assert not (bundle / 'script/MoonYa-index').exists()
    assert not (bundle / 'assets/office').exists()
    assert not (bundle / '.env').exists()
    assert not any(file.suffix.lower() in {'.pem', '.key', '.crt', '.pfx', '.p12', '.cer', '.der'} for file in bundle.rglob('*') if file.is_file()), 'Payment/certificate materials must not ship'
    assert not any(any(marker in file.name.lower() for marker in ('keyring','payment-master','master-key')) for file in bundle.rglob('*') if file.is_file() and file.name != 'payment_keyring_upgrade.sql'), 'Payment master keys must not ship'
    for name in ('index.php', 'office/index.php', 'harness_api.php', 'model_api.php'):
        assert '<html' not in (bundle / name).read_text(encoding='utf-8').lower()
    with tempfile.TemporaryDirectory(prefix='moonya-server-smoke-') as data:
        with socket.socket() as reserve:
            reserve.bind(('127.0.0.1', 0))
            port = reserve.getsockname()[1]
        secret = 'server-smoke-secret-must-not-be-public'
        environment = {**os.environ, 'MOONYA_SERVER_DATA_ROOT': data, 'MOONYA_DATA_ROOT': '',
                       **dict.fromkeys(('DEEPSEEK_API_KEY', 'DB_PASS', 'MINMAX_TTS_API_KEY',
                                        'ALIYUN_ASR_API_KEY', 'YUNZHI_API_TOKEN', 'ALIPAY_APP_ID', 'ALIPAY_SELLER_ID', 'ALIPAY_PRIVATE_KEY_FILE', 'ALIPAY_PUBLIC_KEY_FILE'), secret)}
        process = subprocess.Popen(['php', '-S', f'127.0.0.1:{port}', '-t', str(bundle)],
                                   env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        def request(path, method='GET'):
            try:
                response = urlopen(Request(f'http://127.0.0.1:{port}/{path}',
                                          data=b'{}' if method == 'POST' else None, method=method), timeout=5)
            except HTTPError as response:
                return response.code, response.read().decode('utf-8')
            with response:
                return response.status, response.read().decode('utf-8')
        try:
            for _ in range(100):
                try:
                    status, body = request('api/client_config.php')
                    break
                except URLError:
                    time.sleep(0.05)
            else:
                raise RuntimeError('PHP server did not start')
            # Catalog now comes from MySQL. This intentionally has no DB credentials;
            # supplier/DB errors must remain a generic unavailable response.
            assert status == 503 and json.loads(body) == {'success': False, 'error': '客户端配置暂不可用'}
            assert secret not in body
            for name in ('index.php', 'office/index.php', 'harness_api.php', 'model_api.php', 'statistics.php', 'context_usage.php'):
                status, body = request(name)
                assert status == 410 and json.loads(body)['success'] is False, name
            for name in ('api/model_proxy.php', 'api/client_link.php', 'api/client_feature.php', 'api/membership.php', 'admin/api/membership_orders.php'):
                status, body = request(name, 'POST')
                assert status == 401 and secret not in body, name
            status, body = request('api/alipay.php?action=return')
            assert status == 200 and secret not in body
            for name in ('admin/api/payment_settings.php',):
                status, body = request(name)
                assert status == 403 and secret not in body, name
            status, body = request('admin/payment_settings.php')
            assert status == 200 and 'paymentSettingsSection' in body and secret not in body
            assert (bundle / 'sql/payment_keyring_upgrade.sql').is_file()
            for name in ('sql/payment_security_cli.php', 'sql/migrate_payment_security.php', '检测脚本/payment_security_check.php'):
                status, body = request(quote(name))
                assert status == 404 and secret not in body, name
            print('PHP bundle: public config, credential isolation, protected proxies and retired pages: PASS')
        finally:
            process.terminate()
            process.wait(timeout=5)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    verify(parser.parse_args().bundle)
