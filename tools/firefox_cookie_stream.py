#!/usr/bin/env python3
"""Output an in-memory migration stream of standard Firefox cookies to a local process.
Never redirect stdout to a file or issue tracker: it contains session credentials.
"""
import json, sqlite3, sys, time
from contextlib import closing
from pathlib import Path


def collect(profile):
    file=Path(profile)/'cookies.sqlite'
    if not file.is_file():
        raise FileNotFoundError('Firefox cookies.sqlite not found')
    uri=file.resolve().as_uri()+'?mode=ro'
    included=[]
    reason={'partitioned_or_containers':0,'expired':0,'session':0,'invalid':0,'insecure_none':0}
    now=time.time()
    with closing(sqlite3.connect(uri, uri=True, timeout=10)) as conn:
        for name,value,host,path,expiry,secure,http_only,same_site,attrs in conn.execute(
            'SELECT name,value,host,path,expiry,isSecure,isHttpOnly,sameSite,originAttributes FROM moz_cookies'
        ):
            if attrs:
                reason['partitioned_or_containers']+=1
                continue
            if not host or not isinstance(name,str) or not isinstance(value,str) or not host.strip('.') or not path.startswith('/'):
                reason['invalid']+=1
                continue
            # moz_cookies.expiry is milliseconds since the UNIX epoch, while
            # Chrome's Network.setCookie expects seconds. Convert both the
            # expiry comparison and the value sent over CDP to seconds.
            expiry_seconds=expiry/1000.0 if expiry else 0
            if not expiry_seconds:
                # Session cookies would end with the temporary Chromium session
                # that the importer closes, so importing them would only inflate
                # the accepted count without keeping the login.
                reason['session']+=1
                continue
            if expiry_seconds<now:
                reason['expired']+=1
                continue
            if same_site==0 and not secure:
                reason['insecure_none']+=1
                continue
            cookie={'name':name,'value':value,'domain':host,'path':path,
                    'secure':bool(secure),'httpOnly':bool(http_only),
                    'expires':expiry_seconds}
            # 0=None, 1=Lax, 2=Strict; 256 means no SameSite attribute, so the
            # property is omitted and Chrome keeps its "unspecified" default.
            if same_site in (0,1,2):cookie['sameSite']={0:'None',1:'Lax',2:'Strict'}[same_site]
            included.append(cookie)
    return {'cookies':included,'skipped':reason}

if __name__=='__main__':
    if len(sys.argv)!=2:
        print('Usage: firefox_cookie_stream.py FIREFOX_PROFILE',file=sys.stderr);sys.exit(2)
    json.dump(collect(sys.argv[1]),sys.stdout,ensure_ascii=False,separators=(',',':'))
