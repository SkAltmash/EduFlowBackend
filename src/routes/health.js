import { Router } from "express";
import mongoose from "mongoose";

const router = Router();

router.get("/", (req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.json({
    status: "ok",
    uptime: process.uptime(),
    db: dbConnected ? "connected" : "disconnected",
  });
});

export default router;
