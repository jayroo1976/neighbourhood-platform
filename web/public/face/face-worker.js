// Runs inside /face/face-worker.html (same origin as the app, but its own Content-Security-Policy).
// Protocol (postMessage, same origin only):
//   app  -> {type:'init', id}                       worker -> {type:'init', id} | {type:'error', id, message}
//   app  -> {type:'detect', id, bitmap}             worker -> {type:'result', id, boxes:[{x,y,w,h}]} | {type:'error', id, message}
// Boxes are normalised (0..1) to the bitmap that was sent.
(function () {
  var BASE = '/mediapipe/face_detection/';
  var detector = null;
  var sink = null;
  var ready = null;

  function init() {
    if (!ready) {
      ready = (async function () {
        if (!window.FaceDetection) throw new Error('Face detector missing');
        detector = new window.FaceDetection({ locateFile: function (f) { return BASE + f; } });
        // 'full' covers faces up to about 5 m away; a low threshold favours catching faces over avoiding false alarms
        // (a false alarm costs the resident one tap to remove).
        detector.setOptions({ model: 'full', selfieMode: false, minDetectionConfidence: 0.3 });
        detector.onResults(function (r) { if (sink) sink(r.detections || []); });
        await detector.initialize();
      })();
      ready.catch(function () { ready = null; });
    }
    return ready;
  }

  // whole photo, 2x2 tiles at 60%, 3x3 tiles at 45%: small or distant faces are missed when a big photo is squeezed into the model input
  var TILES = [{ x: 0, y: 0, w: 1, h: 1 }];
  [[2, 0.6], [3, 0.45]].forEach(function (cfg) {
    var n = cfg[0], size = cfg[1];
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) TILES.push({ x: ((1 - size) * i) / (n - 1), y: ((1 - size) * j) / (n - 1), w: size, h: size });
  });

  async function detect(bitmap) {
    await init();
    var W = bitmap.width, H = bitmap.height;
    var work = document.createElement('canvas');
    var boxes = [];
    try {
      for (var k = 0; k < TILES.length; k++) {
        var t = TILES[k];
        var sw = Math.max(1, Math.round(t.w * W)), sh = Math.max(1, Math.round(t.h * H));
        work.width = sw;
        work.height = sh;
        work.getContext('2d').drawImage(bitmap, Math.round(t.x * W), Math.round(t.y * H), sw, sh, 0, 0, sw, sh);
        var dets = [];
        sink = function (d) { dets = d; };
        await detector.send({ image: work });
        for (var d = 0; d < dets.length; d++) {
          var bb = dets[d].boundingBox;
          if (!bb) continue;
          boxes.push({ x: t.x + (bb.xCenter - bb.width / 2) * t.w, y: t.y + (bb.yCenter - bb.height / 2) * t.h, w: bb.width * t.w, h: bb.height * t.h });
        }
      }
    } finally {
      sink = null;
      if (bitmap.close) bitmap.close();
    }
    return boxes;
  }

  window.addEventListener('message', function (ev) {
    if (ev.origin !== location.origin || ev.source !== window.parent) return;
    var m = ev.data || {};
    var reply = function (msg) { window.parent.postMessage(msg, location.origin); };
    if (m.type === 'init') {
      init().then(function () { reply({ type: 'init', id: m.id }); }, function (e) { reply({ type: 'error', id: m.id, message: String((e && e.message) || e) }); });
    } else if (m.type === 'detect') {
      detect(m.bitmap).then(function (boxes) { reply({ type: 'result', id: m.id, boxes: boxes }); }, function (e) { reply({ type: 'error', id: m.id, message: String((e && e.message) || e) }); });
    }
  });

  window.parent.postMessage({ type: 'loaded' }, location.origin);
})();
