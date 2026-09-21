// Keep npm test dependency-free and glob-free: enumerate test files at runtime
// (a quoted glob needs Node >= 21.0/22.0 --test glob support; Node 18/20 fail).
const fs = require("fs"), path = require("path");
const dir = path.join("typesafe-bridge", "test");
const files = fs.readdirSync(dir).filter(f => f.endsWith(".test.cjs")).sort()
  .map(f => path.join(dir, f));
const { spawnSync } = require("child_process");
const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status || 0);
