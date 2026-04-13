;; Detect $this->dep->method() — potential null dereference chain
(member_call_expression
  object: (member_access_expression
    object: (variable_name (name) @root_var)
    name: (name) @property)
  name: (name) @called_method)
