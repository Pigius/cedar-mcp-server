// Viewers can only read
permit (
  principal in DocMgmt::Role::"viewer",
  action == DocMgmt::Action::"READ",
  resource
);
