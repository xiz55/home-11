import json,subprocess
TL=json.load(open('timeline.json'))
files=[];filters=[];labels=[]
def add(f,t,vol,extra=''):
    k=len(files); files.append(f); ms=int(t*1000)
    filters.append(f"[{k}:a]aresample=44100,aformat=channel_layouts=stereo{extra},volume={vol},adelay={ms}|{ms}[a{k}]"); labels.append(f"[a{k}]")
for i,l in enumerate(TL): add(f"v3/l{i:02d}.mp3",l['start'],1.0)
filters.append("".join(labels)+f"amix=inputs={len(labels)}:normalize=0,apad=whole_dur=59,asplit=2[vo][vsc]")
labels=[]
add('sfx_siren.mp3',0.2,0.25,',afade=t=out:st=5.5:d=1.2')
for t in [6.75,16.75,26.85,34.95,41.15,47.3,52.75]: add('sfx_whoosh.mp3',t,0.45)
add('sfx_impact.mp3',12.35,0.6); add('sfx_impact.mp3',17.25,0.55); add('sfx_impact.mp3',50.7,0.4)
add('sfx_paper.mp3',48.1,0.5); add('sfx_shimmer.mp3',53.15,0.45); add('sfx_shimmer.mp3',55.0,0.3)
filters.append("".join(labels)+f"amix=inputs={len(labels)}:normalize=0,apad=whole_dur=59[sfx]")
k=len(files); files.append('music.mp3')
filters.append(f"[{k}:a]aresample=44100,aformat=channel_layouts=stereo,atrim=0:59,volume=0.32,afade=t=in:d=1.5,afade=t=out:st=56.5:d=2.5[mus]")
filters.append("[mus][vsc]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=400[mduck]")
filters.append("[vo][sfx][mduck]amix=inputs=3:normalize=0,atrim=0:59,loudnorm=I=-14:TP=-1.5:LRA=11[out]")
inputs=[x for f in files for x in ('-i',f)]
subprocess.run(['ffmpeg','-y','-loglevel','error']+inputs+['-filter_complex',';'.join(filters),'-map','[out]','-ar','48000','-c:a','pcm_s16le','mix.wav'],check=True)
