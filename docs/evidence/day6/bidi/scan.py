# Lists every line holding a raw bidi / zero-width / tag character (git-tracked and untracked files, .csv exempt).
# Usage: python3 -I scan.py <repo root>
import subprocess,sys,re
root=sys.argv[1]
bad=re.compile('[\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB\U000E0000-\U000E007F]')
files=subprocess.run(['git','-C',root,'ls-files'],capture_output=True,text=True).stdout.split('\n')
# also untracked
files+=subprocess.run(['git','-C',root,'ls-files','--others','--exclude-standard'],capture_output=True,text=True).stdout.split('\n')
if not any(files):  # not a git checkout (e.g. a `git archive` copy): walk it, skipping dependency and build folders
    import os
    files=[os.path.relpath(os.path.join(d,f),root) for d,ds,fs in os.walk(root) for f in fs
           if not ds.__setitem__(slice(None),[x for x in ds if x not in ('node_modules','.next','.git','test-results')])]
n=0;fs=set()
for f in files:
    if not f or f.endswith('.csv'): continue
    try: t=open(f'{root}/{f}',encoding='utf-8').read()
    except Exception: continue
    for i,l in enumerate(t.split('\n'),1):
        m=bad.findall(l)
        if m:
            n+=1;fs.add(f)
            print(f'{f}:{i}: '+' '.join('U+%04X'%ord(c) for c in m))
print('LINES',n,'FILES',len(fs))
