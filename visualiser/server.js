import express from "express";
import cors from "cors";
import fs from "fs/promises";
import { exec } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Path helpers (ESM-safe equivalent of __dirname)
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Absolute path to the compiler directory, resolved relative to this file.
// visualiser/server.js  →  ../compiler/hls_compiler/
const COMPILER_DIR = path.resolve(__dirname, "../compiler/hls_compiler");
const INPUT_FILE = path.join(COMPILER_DIR, "input.txt");
const OUTPUT_FILE = path.join(COMPILER_DIR, "output.json");

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// POST /synthesize
// ---------------------------------------------------------------------------
app.post("/synthesize", async (req, res) => {
  const { code } = req.body;

  if (typeof code !== "string" || code.trim() === "") {
    return res.status(400).json({ error: "Request body must include a non-empty 'code' string." });
  }

  // 1. Write the user's algorithm to input.txt
  try {
    await fs.writeFile(INPUT_FILE, code, "utf8");
  } catch (writeErr) {
    console.error("[server] Failed to write input.txt:", writeErr);
    return res.status(500).json({ error: "Server error: could not write input file.", details: writeErr.message });
  }

  // 2. Run the compiler inside the compiler directory
  const runCompiler = () =>
    new Promise((resolve, reject) => {
      exec("dune exec hls_compiler", { cwd: COMPILER_DIR }, (error, stdout, stderr) => {
        if (error) {
          // Attach stderr so the caller can surface the compiler's diagnostics
          const enriched = new Error(stderr || stdout || error.message);
          enriched.stderr = stderr;
          enriched.stdout = stdout;
          reject(enriched);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

  try {
    await runCompiler();
  } catch (compileErr) {
    console.error("[server] Compiler error:\n", compileErr.stderr);
    return res.status(400).json({
      error: "Compilation failed.",
      // Return raw stderr so the frontend can display syntax / type errors
      details: compileErr.stderr || compileErr.message,
    });
  }

  // 3. Read and return the generated output.json
  try {
    const raw = await fs.readFile(OUTPUT_FILE, "utf8");
    const result = JSON.parse(raw);
    return res.status(200).json(result);
  } catch (readErr) {
    console.error("[server] Failed to read output.json:", readErr);
    return res.status(500).json({
      error: "Compiler succeeded but output.json could not be read or parsed.",
      details: readErr.message,
    });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[server] HLS bridge running at http://localhost:${PORT}`);
  console.log(`[server] Compiler directory: ${COMPILER_DIR}`);
});