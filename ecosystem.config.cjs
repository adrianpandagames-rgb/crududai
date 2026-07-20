module.exports = {
  apps: [
    {
      name: "CRUD-Nodejs-Express-MySQL",
      // Point directly to the npm-cli.js file, NOT npm.cmd
      script: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", 
      args: "run dev",
      cwd: "C:\\Users\\UDAI-ACL\\Documents\\CRUD-Nodejs-Express-MySQL", // Update this path
      exec_mode: "fork", // Essential for npm scripts on Windows
      interpreter: "none" // Prevents PM2 from trying to interpret npm as a node script
    }
  ]
};