function withIdempotency() {
  return (next) => (request) => next(request);
}

module.exports = { withIdempotency };
