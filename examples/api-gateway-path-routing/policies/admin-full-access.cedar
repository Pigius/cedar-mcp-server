// Admins have full access to all endpoints and methods
permit (
  principal in API::Role::"admin",
  action,
  resource
);
