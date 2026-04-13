;; Detect $obj->setFoo(null) — DataObject anti-pattern
;; setX(null) stores ['x' => null] in _data, hasX() returns true via array_key_exists
(member_call_expression
  name: (name) @method_name
  arguments: (arguments
    (argument
      (null))))
