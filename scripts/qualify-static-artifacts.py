import datetime,hashlib,json,os,io,stat,subprocess,zipfile,base64
from pathlib import Path,PurePosixPath
BASE=Path(__file__).resolve().parent
repo='cloud-rebellion/bright-interaction-website'
scratch=Path(os.environ['BUILD_SCRATCH_DIR']);destinations=[];provenance=[]
for label,artifact,source,digest in [
 ('baseline',12999424233,'ba6b6c18eac20cab2c120f18f2e14d3466136f8b','sha256:9ac62e2c0608e48cfd1a49385d15f79e3ee194dc3c4aa82bba4e39d8926a57b8'),
 ('candidate',12999644639,'70c38e87c604569c8ff7dfa061f72567903d81a7','sha256:e1fceaeaac4ad66a8ac34c0b7d56a30e70227c3c0bba014776ae8f9b13f77012')]:
 meta=json.loads(subprocess.check_output(['gh','api',f'repos/{repo}/actions/artifacts/{artifact}']))
 assert not meta['expired'] and meta['digest']==digest and meta['workflow_run']['head_sha']==source
 assert meta['size_in_bytes']<=256*1024*1024
 raw=subprocess.check_output(['gh','api','--allow-escape-sequences',f'repos/{repo}/actions/artifacts/{artifact}/zip'])
 assert len(raw)<=256*1024*1024 and 'sha256:'+hashlib.sha256(raw).hexdigest()==digest
 archive=zipfile.ZipFile(io.BytesIO(raw));entries=archive.infolist();assert len(entries)<=20000 and sum(x.file_size for x in entries)<=256*1024*1024
 dest=scratch/label;dest.mkdir()
 for entry in entries:
  name=PurePosixPath(entry.filename);assert not name.is_absolute() and '..' not in name.parts and not stat.S_ISLNK(entry.external_attr>>16)
  target=dest.joinpath(*name.parts)
  if entry.is_dir():target.mkdir(parents=True,exist_ok=True);continue
  target.parent.mkdir(parents=True,exist_ok=True)
  with target.open('xb') as f:f.write(archive.read(entry))
 destinations.append(str(dest));provenance.append({'label':label,'artifact_id':artifact,'artifact_digest':digest,'source_head':source,'run':meta['workflow_run']['id']})
env={k:os.environ[k] for k in ['PATH','HOME','TMPDIR','BUILD_SCRATCH_DIR','CHROME_PATH'] if k in os.environ}
p=subprocess.run(['bun',str(BASE/'qualify-static-browser.mjs'),*destinations],env=env,text=True,capture_output=True,timeout=90)
if p.returncode:raise RuntimeError(p.stderr[-4000:])
result=json.loads((scratch/'browser-result.json').read_text())
for dataset in result['datasets']:
 for image in dataset['snapshots']:
  path=Path(image['screenshotPath']);assert path.parent==scratch and path.suffix=='.png';image['screenshotPath']=path.name
result.update(time_utc=datetime.datetime.now(datetime.UTC).isoformat(),provenance=provenance,qualification_kind='Temporary exact built-public baseline/candidate comparison; original frozen source CI remains separate',retained_evidence_budget_bytes=5*1024*1024,retention='Qualification screenshots/JSON artifact1day; no runtime tree retained')
assert sum(p.stat().st_size for p in scratch.glob('*.png'))<=5*1024*1024
(scratch/'browser-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'result':result['result'],'differences':result['differences'],'sources':[p['source_head'] for p in provenance]}))
if result['result']!='PASS':raise SystemExit(1)
