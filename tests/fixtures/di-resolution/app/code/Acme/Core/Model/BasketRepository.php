<?php
namespace Acme\Core\Model;

use Acme\Core\Api\BasketRepositoryInterface;

class BasketRepository implements BasketRepositoryInterface
{
    public function save()
    {
        $this->persist();
    }

    private function persist()
    {
    }
}
