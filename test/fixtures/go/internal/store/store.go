// Package store is the only package allowed to touch the database.
package store

import (
	"errors"
	"log"

	"github.com/acme/app/internal/model"
)

// Page size bounds applied when a caller does not pick its own.
const (
	MaxPageSize = 100
	minPageSize = 1
)

// ErrNotFound means the id was well formed but matched no row.
var ErrNotFound = errors.New("user not found")

// Logger is the slice of logging the store actually uses.
type Logger interface {
	Printf(format string, args ...any)
}

// Store answers user queries against an open database.
type Store struct {
	db     *DB
	logger Logger
}

// New wires a store onto an already open database handle.
func New(db *DB) *Store {
	return &Store{db: db, logger: log.Default()}
}

// Get returns one user, or ErrNotFound when there is no such row.
func (s *Store) Get(id model.UserID) (*model.User, error) {
	row, err := s.db.queryUser(string(id))
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, ErrNotFound
	}
	return row, nil
}

// clamp holds a caller supplied page size inside our own bounds.
func clamp(size int) int {
	if size > MaxPageSize {
		return MaxPageSize
	}
	if size < minPageSize {
		return minPageSize
	}
	return size
}
