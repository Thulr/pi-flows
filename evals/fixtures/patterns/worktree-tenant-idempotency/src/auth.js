function withAuth() {
  return (next) => (request) => next(request);
}

module.exports = { withAuth };
