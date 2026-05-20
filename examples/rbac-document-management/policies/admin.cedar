// Admins can do anything on any document
permit (
  principal in DocMgmt::Role::"admin",
  action,
  resource
);
