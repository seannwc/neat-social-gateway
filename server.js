const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 8080;

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Neat Frame to Social Live</title>
</head>
<body style="font-family:sans-serif;background:#111;color:#fff;padding:16px;max-width:480px;margin:auto">
  <h3>Neat Frame &rarr; social Live</h3>
  <label style="font-size:13px;color:#ccc">Social RTMP Server URL + Stream Key:</label>
  <input id="rtmp" placeholder="rtmp://push.social.sg/live/YOUR_STREAM_KEY" style="width:100%;padding:12px;margin:6px 0 12px;box-sizing:border-box;border-radius:6px;border:1px solid #444;background:#222;color:#fff">
  <button id="btn" style="width:100%;padding:14px;font-size:16px;font-weight:bold;background:#ee4d2d;color:#fff;border:0;border-radius:6px;cursor:pointer">Start Streaming</button>
  <p id="wssInfo" style="font-size:12px;color:#4ade80;word-break:break-all"></p>
  <p id="status" style="font-size:13px;color:#aaa">Ready</p>
  <video id="v" autoplay muted playsinline style="width:100%;border-radius:8px;background:#000;margin-top:8px"></video>
  <script>
    const rtmpInput = document.getElementById('rtmp');
    rtmpInput.value = localStorage.getItem('social_rtmp') || '';
    const baseWss = 'wss://' + location.host + '/stream';
    document.getElementById('wssInfo').innerText = 'Gateway WSS URL: ' + baseWss;

    let ws, rec, stream;
    document.getElementById('btn').onclick = async () => {
      if (rec && rec.state === 'recording') {
        rec.stop();
        if (ws) ws.close();
        if (stream) stream.getTracks().forEach(t => t.stop());
        return;
      }
      const rtmp = rtmpInput.value.trim();
      if (!rtmp.startsWith('rtmp://') && !rtmp.startsWith('rtmps://')) {
        return alert('Enter a valid social RTMP URL + Stream Key');
      }
      localStorage.setItem('social_rtmp', rtmp);

      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 720 }, height: { ideal: 1280 } },
        audio: true
      });
      document.getElementById('v').srcObject = stream;

      ws = new WebSocket(baseWss + '?rtmp=' + encodeURIComponent(rtmp));
      document.getElementById('status').innerText = 'Connecting to gateway...';

      ws.onopen = () => {
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
          ? 'video/webm;codecs=vp8,opus' : 'video/webm';
        rec = new MediaRecorder(stream, { mimeType: mime });
        rec.ondataavailable = e => {
          if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data);
        };
        rec.start(250);
        document.getElementById('btn').innerText = 'Stop Streaming';
        document.getElementById('status').innerText = 'LIVE - Pushing to social RTMP';
      };

      ws.onclose = () => {
        document.getElementById('btn').innerText = 'Start Streaming';
        document.getElementById('status').innerText = 'Disconnected';
      };
      ws.onerror = () => {
        document.getElementById('status').innerText = 'WebSocket connection error';
      };
    };
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    return res.end('OK');
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
});

const wss = new WebSocketServer({ server, path: '/stream' });

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const rtmpUrl = params.get('rtmp');

  if (!rtmpUrl || (!rtmpUrl.startsWith('rtmp://') && !rtmpUrl.startsWith('rtmps://'))) {
    ws.close(1008, 'Invalid RTMP URL');
    return;
  }

  console.log('Starting FFmpeg relay to social...');
  const ffmpeg = spawn('ffmpeg', [
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-g', '60',
    '-b:v', '2500k',
    '-maxrate', '2500k',
    '-bufsize', '5000k',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    rtmpUrl
  ]);

  ws.on('message', (chunk) => {
    if (Buffer.isBuffer(chunk) && ffmpeg.stdin.writable) {
      ffmpeg.stdin.write(chunk);
    }
  });

  const cleanup = () => {
    if (ffmpeg.stdin.writable) ffmpeg.stdin.end();
    ffmpeg.kill('SIGINT');
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
  ffmpeg.stderr.on('data', (d) => console.log(d.toString()));
});

server.listen(PORT, () => console.log('Gateway listening on port ' + PORT));
