<?php
declare(strict_types=1);

require dirname(__DIR__) . '/src/Calculator.php';

if (Calculator::add(20, 22) !== 42) {
    fwrite(STDERR, "PHP fixture failed\n");
    exit(1);
}

echo "PHP fixture passed\n";
