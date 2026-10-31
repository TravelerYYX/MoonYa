"""Export the configured local business database without printing credentials."""
from pathlib import Path
import argparse, json, os, subprocess, tempfile
from datetime import datetime
from sql_to_mysql57 import convert
ROOT = Path(__file__).resolve().parents[1]
def export(output):
    config = json.loads(subprocess.check_output(['php', '-r', '$c=require "MoonYa-Backend/config.php";echo json_encode(array_intersect_key($c,array_flip(["db_host","db_name","db_user","db_pass"])));'], cwd=ROOT))
    if config['db_host'] not in ('localhost','127.0.0.1','::1'):
        raise RuntimeError('This export is restricted to the configured local database')
    def quote(value):
        return '"' + str(value).replace('\\','\\\\').replace('"','\\"').replace('\n','\\n').replace('\r','\\r') + '"'
    output=output.resolve();output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='moonya-sql-export-') as temp:
        defaults=Path(temp)/'client.cnf';raw=Path(temp)/'raw.sql'
        defaults.write_text('[client]\n'+''.join(k+'='+quote(config[v])+'\n' for k,v in [('host','db_host'),('user','db_user'),('password','db_pass')]),encoding='utf-8')
        os.chmod(defaults,0o600)
        subprocess.run(['mysqldump','--defaults-extra-file='+str(defaults),'--single-transaction','--column-statistics=0','--set-gtid-purged=OFF','--no-tablespaces','--default-character-set=utf8mb4','--hex-blob','--routines','--events','--triggers','--result-file='+str(raw),config['db_name']],check=True)
        sql,stats=convert(raw.read_bytes().decode('utf-8'),config['db_name'],datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
        output.write_text(sql,encoding='utf-8',newline='\n')
    print('Exported '+str(output)+' ('+str(output.stat().st_size)+' bytes)')
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('output',type=Path);export(parser.parse_args().output)
