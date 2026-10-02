module.exports = {
  apps: [
    {
      name: "index-cycle",
      script: "jobs/indexPipelineCycle.js",
      interpreter: "node",
      //node_args: "--trace-deprecation",
      autorestart: false,
      cron_restart: "0,8,16,24,32,40,48,56 * * * *",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "primefi-market-tail",
      script: "jobs/scanPrimefiMarketEvents.js",
      interpreter: "node",
      autorestart: false,
      cron_restart: "6,36 * * * *",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "index-daily-integrity",
      script: "jobs/indexDailyIntegrity.js",
      interpreter: "node",
      autorestart: false,
      cron_restart: "37 */4 * * *",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
