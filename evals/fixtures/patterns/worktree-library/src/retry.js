function retryDelay(attempt) {
  return 100 * attempt;
}

module.exports = { retryDelay };
