// Public APIs offered on the import page, so the app can be tried without a contract at hand.
// Each one was checked to import cleanly and to answer at the server its contract names (or,
// for FakeRESTApi, which names none, at the origin of its contract URL).
export const SAMPLE_APIS = [
  {
    id: "petstore",
    name: "Swagger Petstore",
    note: "The classic OpenAPI example. Its data is shared by everyone who tries it.",
    url: "https://petstore3.swagger.io/api/v3/openapi.json",
  },
  {
    id: "fakerestapi",
    name: "FakeRESTApi",
    note: "Books, authors, and users with full CRUD. Writes are accepted but not kept, so Flows are safe to run.",
    url: "https://fakerestapi.azurewebsites.net/swagger/v1/swagger.json",
  },
  {
    id: "toolshop",
    name: "Toolshop",
    note: "A shop API built for QA practice, with login, roles, and about 80 endpoints.",
    url: "https://api.practicesoftwaretesting.com/docs?api-docs.json",
  },
  {
    id: "pokeapi",
    name: "PokéAPI",
    note: "A large read-only API (OpenAPI 3.1) for bulk runs and coverage.",
    url: "https://raw.githubusercontent.com/PokeAPI/pokeapi/master/openapi.yml",
  },
];
