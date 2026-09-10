const express = require('express');

const app = express();
const PORT = process.env.PORT || 4001;

app.get('/', (req, res) => {
  res.send(`
    <h1>Example App</h1>
    <p>Running standalone on port ${PORT}, or proxied at /apps/example-app when launched via app-hub.</p>
  `);
});

app.listen(PORT, () => {
  console.log(`example-app listening on port ${PORT}`);
});
