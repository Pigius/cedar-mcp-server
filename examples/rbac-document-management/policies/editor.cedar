// Editors can read and write, but not delete
permit (
  principal in DocMgmt::Role::"editor",
  action in [DocMgmt::Action::"READ", DocMgmt::Action::"WRITE"],
  resource
);
