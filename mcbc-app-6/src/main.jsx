import "./storage.js"; // sets up window.storage before App ever calls it
import "./index.css"; // Tailwind's generated styles
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
