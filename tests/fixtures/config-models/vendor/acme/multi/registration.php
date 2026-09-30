<?php
// Registers the modules below this package (the layout of Mirakl's connector)
foreach (glob(implode(DIRECTORY_SEPARATOR, [__DIR__, '*', 'registration.php']), GLOB_NOSORT) as $file) {
    include $file;
}
