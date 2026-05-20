// Nobody can access top-secret documents except admins
// This forbid overrides all permit policies
forbid (
  principal,
  action,
  resource
)
when {
  resource.classification == "top_secret"
}
unless {
  principal in DocMgmt::Role::"admin"
};
