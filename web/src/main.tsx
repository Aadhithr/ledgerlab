import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { boot } from "./store";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
boot().catch((e) => {
  root.render(
    <div className="empty">
      Could not reach the Ledger Lab server. Is <span className="kbd">ledgerlab start</span> running? ({String(e.message ?? e)})
    </div>,
  );
});
