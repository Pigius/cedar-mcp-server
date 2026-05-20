// Developers can GET and POST to the projects collection and individual projects
// Depth-limiting: allows /api/v1/projects and /api/v1/projects/{id} but NOT deeper paths
permit (
  principal in API::Role::"developer",
  action in [API::Action::"GET", API::Action::"POST"],
  resource
)
when {
  resource.path == "/api/v1/projects"
  || (
    resource.path like "/api/v1/projects/*"
    && !(resource.path like "/api/v1/projects/*/*")
  )
};
