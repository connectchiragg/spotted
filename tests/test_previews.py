import json
import subprocess
from app.previews import prepare_previews


def test_prepares_every_timestamp_at_higher_quality(tmp_path):
    source = tmp_path / 'source.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=12',
                    '-t','9','-c:v','mpeg4',str(source)],check=True)
    uploaded = {}
    indices=prepare_previews(source,[2.0,8.0],9,tmp_path,lambda i,data:uploaded.update({i:data}))
    assert indices==[0,1]
    assert all(data.startswith(b'GIF') for data in uploaded.values())
    output=tmp_path/'test.gif';output.write_bytes(uploaded[0])
    metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(output)]))['streams'][0]
    assert metadata['width']==480
    assert 4.8<=float(metadata['duration'])<=5.2
