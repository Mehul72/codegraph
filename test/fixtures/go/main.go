// Command app serves the user API.
package main

import (
	"log"
	"os"

	userstore "github.com/acme/app/internal/store"
)

// DSN points at the local development database.
const DSN = "postgres://localhost:5432/app?sslmode=disable"

func main() {
	db, err := userstore.Open(DSN)
	if err != nil {
		log.Fatalf("open: %v", err)
	}
	if err := run(userstore.New(db)); err != nil {
		log.Println(err)
		os.Exit(1)
	}
}

// run is the part of main that is allowed to return an error.
func run(s *userstore.Store) error {
	_, err := s.Get("u-1")
	return err
}
