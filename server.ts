import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);
  console.log(`NODE_ENV: ${process.env.NODE_ENV}, PORT: ${PORT}`);

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));

  // Request logging
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
    next();
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      env: process.env.NODE_ENV, 
      cwd: process.cwd(),
      dirname: __dirname
    });
  });

  app.get("/ping", (req, res) => {
    res.send("pong");
  });

  // API Route for scraping
  app.post("/api/scrape", async (req, res) => {
    const { url } = req.body;
    console.log(`Scraping request for: ${url}`);
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      console.log(`Fetching URL: ${url}`);
      const response = await axios.get(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
        timeout: 30000,
      });

      console.log(`Response status: ${response.status}`);
      const $ = cheerio.load(response.data);
      
      // Remove scripts, styles, and other non-content elements
      $("script, style, nav, footer, header, aside, iframe, noscript").remove();

      // Basic content extraction
      const title = $("title").text().trim() || $("h1").first().text().trim() || "Untitled";
      
      // Try to find the main article content
      let content = $("article").text().trim() || $("main").text().trim() || $("body").text().trim();
      
      // Clean up whitespace
      content = content.replace(/\s+/g, " ").substring(0, 15000);

      console.log(`Scraping successful: ${title}`);
      res.json({ title, content });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Scraping error:", errorMessage);
      res.status(500).json({ error: "Failed to scrape content: " + errorMessage });
    }
  });

  // Vite middleware for development
  const isDev = process.env.NODE_ENV === "development";
  console.log(`Running in ${isDev ? "DEVELOPMENT" : "PRODUCTION"} mode (NODE_ENV=${process.env.NODE_ENV})`);
  if (isDev) {
    console.log("Starting in development mode with Vite middleware");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    console.log(`Starting in production mode serving static files from: ${distPath}`);
    
    // Check if dist exists
    if (!fs.existsSync(distPath)) {
      console.error(`ERROR: dist directory not found at ${distPath}`);
      // Fallback to __dirname if process.cwd() fails
      const fallbackPath = path.resolve(__dirname, "dist");
      if (fs.existsSync(fallbackPath)) {
        console.log(`Found dist at fallback path: ${fallbackPath}`);
        app.use(express.static(fallbackPath));
        app.get("*", (req, res) => {
          res.sendFile(path.join(fallbackPath, "index.html"), (err) => {
            if (err) {
              console.error("Error sending index.html from fallback:", err);
              res.status(500).send("Error loading application from fallback.");
            }
          });
        });
      } else {
        app.get("*", (req, res) => {
          res.status(404).send(`Error: dist directory not found. Checked ${distPath} and ${fallbackPath}`);
        });
      }
    } else {
      console.log(`dist directory found at ${distPath}`);
      if (fs.existsSync(path.join(distPath, "index.html"))) {
        console.log(`index.html found at ${path.join(distPath, "index.html")}`);
      } else {
        console.error(`ERROR: index.html not found in ${distPath}`);
      }
      
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"), (err) => {
          if (err) {
            console.error("Error sending index.html:", err);
            res.status(500).send("Error loading application.");
          }
        });
      });
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("CRITICAL: Failed to start server:", err);
  process.exit(1);
});
