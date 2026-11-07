// Loaded only into isolated SDK/OAuth fixture processes.
import fs from "node:fs";
fs.statfsSync = () => {
  if (process.env.FIXTURE_STATFS === "unavailable") throw Error("fixture unavailable");
  return { bsize: 1n, bavail: BigInt(process.env.FIXTURE_STATFS === "emergency" ? 24 : 100) * 1024n ** 3n };
};
