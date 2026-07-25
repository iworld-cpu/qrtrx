const mqtt = require("mqtt");
const URLS = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt"
];
const TOPIC = "qrtrx/v1/presence";
let i = 0;
function tryUrl() {
  if (i >= URLS.length) { console.log("ALL_FAIL"); process.exit(2); }
  const url = URLS[i++];
  console.log("TRY", url);
  const c = mqtt.connect(url, { clientId: "diag_" + Math.random().toString(16).slice(2), connectTimeout: 8000, reconnectPeriod: 0 });
  const t = setTimeout(() => { console.log("TIMEOUT", url); try{c.end(true)}catch{}; tryUrl(); }, 10000);
  c.on("connect", () => {
    clearTimeout(t);
    console.log("CONNECTED", url);
    c.subscribe(TOPIC, (err) => {
      if (err) console.log("SUB_ERR", err.message);
      else console.log("SUB_OK", TOPIC);
      const payload = JSON.stringify({ t:"presence", id:"diag1", name:"DiagPC", room:"", status:"online", ts:Date.now() });
      c.publish(TOPIC, payload, () => console.log("PUB_OK"));
      // second client
      const c2 = mqtt.connect(url, { clientId: "diag2_" + Math.random().toString(16).slice(2), connectTimeout: 8000, reconnectPeriod: 0 });
      c2.on("connect", () => {
        c2.subscribe(TOPIC);
        c2.publish(TOPIC, JSON.stringify({ t:"presence", id:"diag2", name:"DiagPhone", room:"ABC123", status:"room", ts:Date.now() }));
      });
      c.on("message", (topic, buf) => {
        console.log("MSG", buf.toString().slice(0,120));
      });
      setTimeout(() => { console.log("DONE_OK"); c.end(true); c2.end(true); process.exit(0); }, 3000);
    });
  });
  c.on("error", (e) => { console.log("ERR", url, e.message); });
}
tryUrl();
