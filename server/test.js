import 'dotenv/config';
import dns from "node:dns";
import mongoose from "mongoose";

dns.setServers(["8.8.8.8", "1.1.1.1"]);

console.log("DNS:", dns.getServers());

mongoose.set("debug", true);

const uri = process.env.MONGO_URI; // or your URI

(async () => {
  try {
    console.log("Connecting...");

    const timeout = setTimeout(() => {
      console.log("❌ 15 seconds elapsed");
      process.exit(1);
    }, 15000);

    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });

    clearTimeout(timeout);
    console.log("✅ Connected");
  } catch (e) {
    console.error(e);
  } finally {
    process.exit();
  }
})();