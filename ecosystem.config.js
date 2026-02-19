module.exports = {
  apps: [
    {
      name: "index-cycle",
      script: "jobs/indexPipelineCycle.js",
      interpreter: "node",
      //node_args: "--trace-deprecation",
      autorestart: false,
      cron_restart: "*/10 * * * *",
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
      name: "index-daily-integrity",
      script: "jobs/indexDailyIntegrity.js",
      interpreter: "node",
      autorestart: false,
      cron_restart: "30 */4 * * *",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
