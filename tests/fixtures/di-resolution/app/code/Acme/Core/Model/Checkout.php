<?php
namespace Acme\Core\Model;

// Constructor hints are short names, imported by `use` (one aliased) — as in most Magento code
use Acme\Core\Api\BasketRepositoryInterface;
use Acme\Core\Model\Validator\BasketValidator as Validator;

class Checkout
{
    public function __construct(
        private BasketRepositoryInterface $basketRepository,
        private Validator $validator
    ) {
    }

    public function place()
    {
        $this->validator->validate();
        $this->basketRepository->save();
    }
}
