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
      name: "scan-loan-lp",
      script: "jobs/scanLoanLpPositions.js",
      interpreter: "node",
      autorestart: false,
      cron_restart: "2,10,18,26,34,42,50,58 * * * *",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "index-tail",
      script: "jobs/indexTail.js",
      interpreter: "node",
      autorestart: false,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "index-derive-nft",
      script: "jobs/deriveNftStateFromEvents.js",
      interpreter: "node",
      autorestart: false,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "sp-snapshot-hourly",
      script: "jobs/collectStabilityPoolSnapshots.js",
      interpreter: "node",
      autorestart: false,
      cron_restart: "6 * * * *",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "sp-position-scan",
      script: "jobs/scanStabilityPoolPositions.js",
      interpreter: "node",
      autorestart: false,
      cron_restart: "5,15,25,35,45,55 * * * *",
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
