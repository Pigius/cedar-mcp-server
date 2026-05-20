// Private documents are blocked for everyone except the owner
// Uses optional attribute guard: check visibility before accessing
forbid (
  principal,
  action,
  resource
)
when {
  resource.visibility == "private"
}
unless {
  principal.name == resource.owner_id
};
