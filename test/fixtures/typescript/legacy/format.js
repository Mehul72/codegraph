/** Render a sample count as a rough duration string. */
function formatDuration(samples) {
  return `${samples * 10}ms`;
}

module.exports = { formatDuration };
