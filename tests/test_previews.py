import json
import shutil
import subprocess

from app.previews import evidence_gif


def test_gif_starts_at_citation_is_small_and_cached(tmp_path):
    source = tmp_path / 'source.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=12',
                    '-t','9','-c:v','mpeg4',str(source)],check=True)
    class Cloud:
        calls = 0
        def download(self, job, path):
            self.calls += 1
            shutil.copyfile(source, path)
    cloud = Cloud()
    job = {'object_key':'test', 'result':{'sampled_timestamps':[2.0,8.0]}}
    output = evidence_gif(job,0,cloud,tmp_path/'cache')
    metadata = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(output)]))['streams'][0]
    assert metadata['width'] == 240
    assert metadata['height'] <= 240
    assert 4.8 <= float(metadata['duration']) <= 5.2
    assert evidence_gif(job,0,cloud,tmp_path/'cache') == output
    assert cloud.calls == 1
    short = evidence_gif(job,1,cloud,tmp_path/'cache')
    assert short != output and short.read_bytes().startswith(b'GIF')
