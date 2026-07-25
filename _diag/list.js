const mqtt = require("mqtt");
const c = mqtt.connect("wss://broker.emqx.io:8084/mqtt", { clientId: "diaglist_"+Date.now(), reconnectPeriod: 0 });
const seen = new Map();
c.on("connect", () => {
  c.subscribe("qrtrx/v1/presence");
  setTimeout(() => {
    console.log("ACTIVE_COUNT", seen.size);
    for (const [id,p] of seen) console.log(JSON.stringify(p));
    c.end(true); process.exit(0);
  }, 6000);
});
c.on("message", (_, buf) => {
  try {
    const d = JSON.parse(buf.toString());
    if (d.t === "presence" && d.id) seen.set(d.id, { name:d.name, room:d.room||"", status:d.status, age: Date.now()-(d.ts||0) });
  } catch {}
});
c.on("error", e => console.log("ERR", e.message));
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 12000);
