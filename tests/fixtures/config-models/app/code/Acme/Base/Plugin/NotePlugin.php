<?php
namespace Acme\Base\Plugin;

use Acme\Base\Model\NoteRepository;

class NotePlugin
{
    public function beforeSave(NoteRepository $subject): void
    {
        $marker = 'acme-note-plugin-body';
    }
}
