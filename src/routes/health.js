import { Router } from "express";
import mongoose from "mongoose";

const router = Router();

router.get("/", (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.json({
    status: "ok",
    uptime: process.uptime(),
    db: dbConnected ? "connected" : "disconnected",
    // The caller's IP as the server sees it (what rate limiting uses). Should match your
    // own public IP; if it shows a proxy's IP instead, adjust TRUST_PROXY.
    yourIp: req.ip,
  });
});

export default router;
