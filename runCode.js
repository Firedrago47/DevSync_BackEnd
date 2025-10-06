const { exec } = require('child_process');
const fs = require('fs');

exports.runCode = (code) => {
  return new Promise((resolve) => {
    const timestamp = Date.now();
    const filePath = `temp_${timestamp}.py`;

    // Write Python code to temp file
    fs.writeFileSync(filePath, code);

    require('dotenv').config();
    const pythonPath = process.env.PYTHON_PATH || 'python';
    exec(`${pythonPath} ${filePath}`, (err, stdout, stderr) => {
      // Delete temp file
      fs.unlinkSync(filePath);

      if (err || stderr) {
        resolve(stderr || err.message);
      } else {
        resolve(stdout || 'Code executed successfully!');
      }
    });
  });
};
