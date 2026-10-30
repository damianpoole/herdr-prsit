# Optional Linux/macOS PTY check. Requires Python 3; uses only temporary local fixtures.
import signal, sys, fcntl, json, os, pathlib, pty, select, shutil, struct, subprocess, tempfile, termios, time
root=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='prsit-dashboard-pty-') as tmp:
    state=pathlib.Path(tmp)
    (state/'watches').mkdir()
    watch={'id':'fixture','number':42,'owner':'fixture','repo':'local-only','url':'https://github.com/fixture/local-only/pull/42','created':1}
    (state/'watches'/'fixture.json').write_text(json.dumps(watch))
    (state/'fixture').mkdir()
    (state/'fixture'/'status.json').write_text(json.dumps({'status':'repairing','message':'Local fixture only','job':{'items':[{'kind':'thread'}]}}))
    (state/'fixture'/'events.log').write_text('Local fixture activity\n')
    master,slave=pty.openpty()
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0))
    env=dict(os.environ,PRSIT_HOME=tmp,TERM='xterm-256color')
    env.pop('NODE_TEST_CONTEXT',None)
    process=subprocess.Popen([shutil.which('node'),str(root/'dist/cli.js'),'dashboard'],stdin=slave,stdout=slave,stderr=slave,env=env)
    os.close(slave)
    output=bytearray()
    def collect():
        if select.select([master],[],[],0.05)[0]:
            try: output.extend(os.read(master,65536))
            except OSError: pass
    def until(predicate, message):
        deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            collect()
            if predicate(): return
            if process.poll() is not None: break
        raise AssertionError(message+'\n'+output.decode(errors='replace')[-4000:])
    def control():
        path=state/'fixture'/'control.json'
        return json.loads(path.read_text()) if path.exists() else {}
    try:
        until(lambda:b'#42 fixture/local-only' in output,'dashboard did not render')
        assert b'Controller STOPPED' in output
        os.write(master,b'p');until(lambda:control().get('mode')=='paused','pause did not apply')
        os.write(master,b'r');until(lambda:control().get('mode')=='running','resume did not apply')
        os.write(master,b't');until(lambda:'retryAt' in control(),'retry did not apply')
        os.write(master,b'u');until(lambda:control().get('mode')=='removed','unwatch did not apply')
        until(lambda:b'All PRs are unwatched' in output,'unwatched PR was not hidden')
        os.write(master,b'h');until(lambda:b'UNWATCHED' in output,'history did not reveal the PR')
        os.write(master,b'r');until(lambda:control().get('mode')=='running','resume from history did not apply')
        fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',24,72,0,0))
        process.send_signal(signal.SIGWINCH)
        mode=sys.argv[1] if len(sys.argv)>1 else 'quit'
        if mode == 'signal': process.send_signal(signal.SIGTERM)
        else: os.write(master,b'\x03' if mode == 'ctrl-c' else b'q')
        until(lambda:process.poll() is not None,'quit did not exit')
        assert process.returncode==0
        assert b'\x1b[?25h' in output and b'\x1b[?1049l' in output,'terminal was not restored'
        print('PTY smoke passed: render, stopped status, pause, resume, retry, unwatch, history, quit, cursor/screen restoration; local fixture only.')
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=8)
        os.close(master)
