import { render } from "preact";
import "./index.css";
import "./styles/views.css";
import { App } from "./app.tsx";
import { writeAppManifest } from "./lib/appManifest";
import { BUS_VERSION } from "./lib/sharedBus";

render(<App />, document.getElementById("app")!);

writeAppManifest({
  app: "tc-lingo",
  busVersion: BUS_VERSION,
  publishes: [],
  consumes: ["lingo-card-inbox"],
  reads: [],
});
