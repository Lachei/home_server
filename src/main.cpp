#include <iostream>
#include <regex>
#include <memory>
#include <mutex>
#include <span>
#include <unordered_set>
#include "httplib.h"

#include "Credentials.hpp"
#include "Database.hpp"
#include "database_util.hpp"
#include "data_util.hpp"
#include "editor_util.hpp"
#include "page_util.hpp"
#include "string_split.hpp"
#include "git_util.hpp"
#include "system_util.hpp"
#include "log.hpp"

#define TRY(expr) try { expr; } catch (const std::exception &e) { LOG_WARNING << e.what(); }

using httplib::Request;
using httplib::Response;
using httplib::StatusCode;

static Credentials &credentials_singleton() {
    static Credentials credentials("credentials/cred.json");
    return credentials;
}

static void set_json(Response &res, const nlohmann::json &j) {
    res.set_content(j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace), "application/json");
}

// Resolves the credentials of a request from the login header, the credentials cookie or a digest Authorization header
// and stores them in the user_data of the response (read by get_authorized_username()).
// If the credentials were freshly resolved from a login or Authorization header they are also stored for the
// post routing handler which sets the credentials cookie.
static constexpr std::string_view cookie_user_data_key{"cookie_content"};
static void resolve_credentials(const Request &req, Response &res) {
    const std::string cred_key{credentials_user_data_key};
    if (req.has_header("login")) {
        std::string login = req.get_header_value("login");
        res.user_data.set(cred_key, login);
        if (valid_credential(login, credentials_singleton()))
            res.user_data.set(std::string(cookie_user_data_key), login);
        return;
    }

    if (req.has_header("Cookie")) {
        std::string cookie = req.get_header_value("Cookie");
        if (valid_cookie_credential(cookie, credentials_singleton())) {
            res.user_data.set(cred_key, cookie_extract_credential(cookie));
            return;
        }
    }

    if (!req.has_header("Authorization")) // if no Authorization filed given, cannot convert to credentials
        return;
    try {
        std::string username = get_authorized_username(req, res, credentials_singleton());
        std::string sha = credentials_singleton().get_credential(username);
        res.user_data.set(cred_key, username + ":" + sha);
        res.user_data.set(std::string(cookie_user_data_key), username + ":" + sha);
    } catch (...) {}
}

struct default_groups{
    static constexpr std::string_view unauthorized_user{"unautorisierte_benutzer"};
    static constexpr std::string_view authorized_user{"autorisierte_benutzer"};
};
struct default_users{
    static constexpr std::string_view unauthorized_user{"unautorisierter_benutzer"};
    static constexpr std::string_view authorized_user{"autorisierter_benutzer"};
};

void print_help()
{
    std::cout << "Home server can be called with the following command line arguments:\n";
    std::cout << "    ./home_server [OptionalArgs] --data data/path\n";
    std::cout << "RequiredArgs:\n";
    std::cout << "    --data     : The directory where the data tab stores all data files\n";
    std::cout << "    --databases: The directory where the databases are stored\n";
    std::cout << "    --cert     : The directory where the certificate files can be found\n";
    std::cout << "OptionalArgs:\n";
    std::cout << "    --help    : Prints this help dialogue\n";
}

std::string_view get_parameter(std::span<const char*> args, std::string_view parameter) {
    if (!std::ranges::contains(args, parameter))
        return {};

    auto e = std::ranges::find(args, parameter);
    if (e == args.end() || ++e == args.end())
        return {};

    return *e;
}

// Creates the https server if certificates are found in the certificates folder, else a plain http server
static std::unique_ptr<httplib::Server> create_server(std::string_view certificates_folder) {
#ifdef CPPHTTPLIB_SSL_ENABLED
    const std::string folder{certificates_folder};
    const auto exists = [&folder](const char *file) { return std::filesystem::exists(folder + "/" + file); };
    std::string cert, key;
    if (exists("cert.pem") && exists("privkey.pem"))
        cert = folder + "/cert.pem", key = folder + "/privkey.pem";
    else if (exists("rsa.key") && exists("rsa.cert"))
        cert = folder + "/rsa.cert", key = folder + "/rsa.key";
    else if (exists("rsa.pem")) // certificate and private key in a single file
        cert = folder + "/rsa.pem", key = folder + "/rsa.pem";

    if (cert.size()) {
        auto server = std::make_unique<httplib::SSLServer>(cert.c_str(), key.c_str());
        if (server->is_valid())
            return server;
        LOG_ERROR << "Could not load the certificate files " << cert << " and " << key << ". Starting server without certs";
    } else {
        LOG_ERROR << "Could not find the certificates files in the given certificates folder: " << certificates_folder << ". Starting sever without certs";
    }
#else
    LOG_WARNING << "Server was compiled without ssl support, starting server without certs";
#endif
    return std::make_unique<httplib::Server>();
}

using namespace std::string_view_literals;
int main(int argc, const char** argv) {
    std::span<const char*> args(argv, argc);
    bool show_help = std::ranges::contains(args, "--help"sv);

    std::string data_base_folder = std::string(get_parameter(args, "--data"));
    if (data_base_folder.empty()) {
        LOG_WARNING << "Missing --data argument, setting it to 'daten/'.";
        show_help = true;
        data_base_folder = "daten/";
    }
    if (data_base_folder.back() != '/') {
        LOG_WARNING << "Data folder missing slash at the and, adding it automatically";
        data_base_folder += '/';
    }

    std::string_view certificates_folder = get_parameter(args, "--cert");
    if (certificates_folder.empty()) {
        LOG_WARNING << "Missing --cert argument, defaulting to data/certificates/";
        show_help = true;
        certificates_folder = "data/certification/";
    }

    std::string_view databases_folder = get_parameter(args, "--databases");
    if (databases_folder.empty()) {
        LOG_WARNING << "Missing --databases argument, defaulting to 'data/'";
        databases_folder = "data/";
    }

    if (show_help)
        print_help();

    std::unique_ptr<httplib::Server> server = create_server(certificates_folder);
    httplib::Server &app = *server;
    app.set_exception_handler([](const Request &req, Response &res, std::exception_ptr ep) {
        try {
            std::rethrow_exception(ep);
        } catch (const http_status &e) {
            // special handle for unauthorized error
            res.status = e.status;
            for (const auto &[key, val]: e.headers)
                res.set_header(key, val);
            LOG_ERROR << "Status error " << e.status << " for " << req.path << ": " << e.what();
        } catch (const std::exception &e) {
            res.status = StatusCode::InternalServerError_500;
            res.set_content("500 Internal Server Error", "text/plain");
            LOG_ERROR << "An uncaught exception occurred for " << req.path << ": " << e.what();
        } catch (...) {
            res.status = StatusCode::InternalServerError_500;
            res.set_content("500 Internal Server Error", "text/plain");
            LOG_ERROR << "An uncaught exception occurred for " << req.path;
        }
    });
    app.set_pre_routing_handler([](const Request &req, Response &res) {
        resolve_credentials(req, res);
        return httplib::Server::HandlerResponse::Unhandled;
    });
    app.set_post_routing_handler([](const Request &req, Response &res) {
        if (const std::string *cookie = res.user_data.get<std::string>(std::string(cookie_user_data_key)); cookie && cookie->size())
            res.set_header("Set-Cookie", "credentials=" + *cookie + "; Max-Age=31536000; SameSite=Strict; Path=/");
    });
    app.set_logger([](const Request &req, const Response &res) {
        LOG_INFO << "Request: " << req.remote_addr << " " << req.method << " " << req.path << " " << res.status;
    });

    Credentials &credentials = credentials_singleton();
    Database database(std::string(databases_folder) + "events");
    database_util::setup_event_table(database);
    database_util::setup_shift_tables(database);
    data_util::setup_data(data_base_folder);
    TRY(git_util::init_git(data_base_folder));

    std::mutex invoice_file_mutex{};

    const auto authorized_user = [&credentials](const Request &req, Response &res) {
        return get_authorized_username(req, res, credentials);
    };

    // ------------------------------------------------------------------------------------------------
    // Login/authentication
    // ------------------------------------------------------------------------------------------------
    const std::string main_page_text = page_util::load_template("main.html");
    app.Get("/", [&main_page_text](const Request &req, Response &res) {
        res.set_content(main_page_text, "text/html");
    });

    app.Get("/login", [&](const Request &req, Response &res) {
        authorized_user(req, res);
    });

    app.Get("/change_password/([^/]+)", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        const std::string user = req.matches[1];

        if (!req.has_header("new_pwd")) {
            res.set_content("Missing new_pwd in header infos", "text/plain");
            return;
        }
        const std::string new_pwd = req.get_header_value("new_pwd");

        if(username != user && username != admin_name) {
            res.set_content("Only admin can change password of other users", "text/plain");
            return;
        }

        bool success = credentials.set_credential(user, new_pwd);
        if (success) {
            res.set_content("success", "text/plain");
            if (user == username) // only if the password for the issuer is changed the cookie has to be reset
                res.set_header("Set-Cookie", "credentials=" + user + ':' + new_pwd + "; Max-Age=31536000; SameSite=Strict; Path=/");
        } else {
            res.set_content("failed", "text/plain");
        }
    });

    app.Get("/delete_user/([^/]+)", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        const std::string user = req.matches[1];

        if (user == admin_name) {
            res.status = StatusCode::Forbidden_403;
            return;
        }

        bool success = credentials.delete_credential(user);
        res.set_content(success ? "success" : "error", "text/plain");
    });

    app.Get("/get_all_users", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        set_json(res, credentials.get_user_list());
    });

    // ------------------------------------------------------------------------------------------------
    // Group and file access changes
    // ------------------------------------------------------------------------------------------------
    app.Get("/groups", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        if (username != admin_name) {
            res.status = StatusCode::Forbidden_403;
            return;
        }
        set_json(res, get_groups());
    });
    app.Post("/add_group", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        if (username != admin_name) {
            res.status = StatusCode::Forbidden_403;
            return;
        }
        if (!req.has_header("groupname"))
            throw std::runtime_error{"Missing groupname header"};
        add_group(req.get_header_value("groupname"));
    });
    app.Post("/delete_group", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        if (username != admin_name) {
            res.status = StatusCode::Forbidden_403;
            return;
        }
        if (!req.has_header("groupname"))
            throw std::runtime_error{"Missing groupname header"};
        delete_group(req.get_header_value("groupname"));
    });

    // ------------------------------------------------------------------------------------------------
    // Git information
    // ------------------------------------------------------------------------------------------------
    app.Get("/git_history/(.+)", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        res.set_content(git_util::get_history_response(data_base_folder + std::string(req.matches[1])), "text/html");
    });
    app.Get("/git_commit", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        if (!req.has_header("file_path"))
            return res.set_content("missing file_path", "text/plain");
        if (!req.has_header("git_hash"))
            return res.set_content("missing git_hash", "text/plain");

        res.set_content(git_util::get_commit(req.get_header_value("file_path"), req.get_header_value("git_hash")), "text/plain");
    });


    // ------------------------------------------------------------------------------------------------
    // Event creation, editing, deletion, querying
    // ------------------------------------------------------------------------------------------------
    app.Get("/get_events", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        set_json(res, database_util::get_events(database, username));
    });
    app.Get(R"(/get_event/(\d+))", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        const uint64_t event_id = std::stoull(req.matches[1]);

        set_json(res, database_util::get_event(database, username, event_id));
    });
    std::mutex update_cache_mutex;
    std::vector<std::pair<std::chrono::utc_clock::time_point, nlohmann::json>> update_cache;
    app.Post("/add_event", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        try{
            const auto& event = nlohmann::json::parse(req.body);
            const auto& creator = event["creator"].get<std::string>();
            if (creator != username && username != admin_name)
                return set_json(res, {{"error", "can not create event for other users, only admin can do that"}});

            auto result = database_util::add_event(database, event);
            {
                std::scoped_lock lock{update_cache_mutex};
                update_cache.emplace_back(std::chrono::utc_clock::now(), result);
            }
            set_json(res, result);
        } catch(const nlohmann::json::parse_error &e){
            set_json(res, {{"error", e.what()}});
        }
    });
    app.Post("/update_event", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        const auto event = nlohmann::json::parse(req.body);
        const auto& creator = event["creator"].get<std::string>();
        bool user_affected = creator == username || username == admin_name;
        for (auto user: string_split{json_array_to_comma_list(event["people"].get<std::string>()), ","sv})
            if (user == username)
                user_affected = true;
        if (!user_affected)
            return set_json(res, {{"error", "can not update an event from another user, only admin can do that"}});
        {
            std::scoped_lock lock{update_cache_mutex};
            update_cache.emplace_back(std::chrono::utc_clock::now(), event);
        }

        set_json(res, database_util::update_event(database, event));
    });
    app.Get("/get_updated_events", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        // removing old entries
        nlohmann::json ret{};
        {
            std::scoped_lock lock{update_cache_mutex};
            auto p{update_cache.begin()};
            for (; p != update_cache.end() && p->first < std::chrono::utc_clock::now() - std::chrono::minutes(5); ++p);
            update_cache.erase(update_cache.begin(), p);
            for (const auto &[time, event]: update_cache)
                ret.push_back(event);
        }

        set_json(res, ret);
    });
    app.Get(R"(/delete_event/(\d+))", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        const uint64_t id = std::stoull(req.matches[1]);

        set_json(res, database_util::delete_event(database, username, id));
    });

    // ------------------------------------------------------------------------------------------------
    // Shift editing
    // ------------------------------------------------------------------------------------------------
    app.Get("/start_shift/([^/]+)", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        const std::string user = req.matches[1];

        if (username != user && username != admin_name)
            return set_json(res, {{"error", "can not begin shift for another user, only admin can do that"}});

        const std::string comment = req.get_header_value("comment");
        set_json(res, database_util::start_shift(database, user, comment));
    });
    app.Get("/start_shift", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        const std::string comment = req.get_header_value("comment");
        set_json(res, database_util::start_shift(database, username, comment));
    });
    app.Get("/check_active_shift/([^/]+)", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        const std::string user = req.matches[1];

        if (username != user && username != admin_name)
            return set_json(res, {{"error", "can not check shift for another user, only admin can do that"}});

        set_json(res, database_util::check_active_shift(database, user));
    });
    app.Get("/end_shift/([^/]+)", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        const std::string user = req.matches[1];

        if (username != user && username != admin_name)
            return set_json(res, {{"error", "can not end shift for another user, only admin can do that"}});

        const auto result = database_util::end_shift(database, user);
        data_util::try_add_shift_to_rech(username, data_base_folder, std::chrono::minutes(result["shift_length"].get<int>()), result["comment"].get<std::string>());
        set_json(res, result);
    });
    app.Get("/end_shift", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        const auto result = database_util::end_shift(database, username);
        data_util::try_add_shift_to_rech(username, data_base_folder, std::chrono::minutes(result["shift_length"].get<int>()), result["comment"].get<std::string>());
        set_json(res, result);
    });
    app.Get("/get_shifts", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        set_json(res, database_util::get_shifts_grouped(database));
    });
    app.Get(R"(/get_shift/(\d+))", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        const uint64_t shift_id = std::stoull(req.matches[1]);

        set_json(res, database_util::get_shift(database, shift_id));
    });
    app.Post("/update_shift", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        const auto shift = nlohmann::json::parse(req.body);
        const auto& user = shift["user"].get<std::string>();
        if (user != username && username != admin_name)
            return set_json(res, {{"error", "can not update a shift of another person, only admin can do that"}});

        set_json(res, database_util::update_shift(database, shift));
    });
    app.Get(R"(/delete_shift/(\d+))", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);
        const uint64_t shift_id = std::stoull(req.matches[1]);

        set_json(res, database_util::delete_shift(database, username, shift_id));
    });
    app.Post("/add_shift", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        const auto shift = nlohmann::json::parse(req.body);
        if(shift["user"].get<std::string>() != username && username != admin_name)
            return set_json(res, {{"error", "can not insert a shift of another user, only admin can do that"}});

        set_json(res, database_util::add_shift(database, shift));
    });

    // ------------------------------------------------------------------------------------------------
    // Data processing
    // ------------------------------------------------------------------------------------------------
    app.Get("/daten/", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        set_json(res, data_util::get_dir_infos(data_base_folder, ""));
    });
    app.Get("/daten/(.+)", [&](const Request &req, Response &res) {
        const std::string path = req.matches[1];
        // sanity check which avoids any .. in the path. This hinders users to get folders
        // outside of the data subfolder which would be a security violation
        if (path.find("..") != std::string::npos)
            return set_json(res, {{"error", ".. is not allowed in the path."}});

        // fast allowed return for applications
        std::filesystem::path file_path = data_base_folder + path;
        if (path.starts_with("Anwendungen/")) {
            LOG_INFO << "No user check for file " << file_path;
            if (std::filesystem::exists(file_path) && !std::filesystem::is_directory(file_path))
                res.set_file_content(file_path.string());
            else
                set_json(res, data_util::get_dir_infos(data_base_folder, path));
            return;
        }

        std::string username = authorized_user(req, res);

        if (std::filesystem::exists(file_path) && !std::filesystem::is_directory(file_path)) {
            bool raw = req.get_param_value("raw") == "true";
            bool edit = req.get_param_value("edit") == "true";
            std::string ext = file_path.extension().string();
            if (!raw && editor_util::is_extension_editor(ext))
                editor_util::get_editor(res, edit, path, data_base_folder);
            else
                res.set_file_content(file_path.string());
        }
        else
            set_json(res, data_util::get_dir_infos(data_base_folder, path));
    });
    app.Post("/upload_daten", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        if (!req.has_header("path"))
            return set_json(res, {{"error", "The path header is missing in the request"}});
        set_json(res, data_util::update_file(username, data_base_folder + req.get_header_value("path"), to_bin_span(req.body)));
    });
    app.Get("/create_folder", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        if (!req.has_header("path"))
            return set_json(res, {{"error", "The path header is missing in the request"}});
        set_json(res, data_util::create_dir(username, data_base_folder + req.get_header_value("path")));
    });
    app.Get("/create_file", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        if (!req.has_header("path"))
            return set_json(res, {{"error", "The path header field is missing in the reqeust"}});
        set_json(res, data_util::update_file(username, data_base_folder + req.get_header_value("path")));
    });
    app.Post("/update_file", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        if (!req.has_header("path"))
            return set_json(res, {{"error", "The path header field is missing in the reqeust"}});
        const std::string base_revision = req.get_header_value("revision");
        set_json(res, data_util::update_file(username, data_base_folder + req.get_header_value("path"), to_bin_span(req.body), base_revision));
    });
    app.Get("/check_file_revision", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        if (!req.has_header("path"))
            return set_json(res, {{"error", "The path header field is missing in the reqeust"}});
        if (!req.has_header("revision"))
            return set_json(res, {{"error", "The path revision field is missing in the reqeust"}});

        std::string path{data_base_folder + req.get_header_value("path")};
        std::string client_revision{req.get_header_value("revision")};

        res.set_content(data_util::check_file_revision(path, client_revision), "application/json");
    });
    app.Post("/move_daten", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        const auto move_infos = nlohmann::json::parse(req.body);
        set_json(res, data_util::move_files(username, data_base_folder, move_infos));
    });
    app.Post("/delete_daten", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        const auto delete_files = nlohmann::json::parse(req.body);
        set_json(res, data_util::delete_files(username, data_base_folder, delete_files));
    });

    app.Get("/create_rech", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        if (!req.has_header("path"))
            return set_json(res, {{"error", "The path header field is missing in the reqeust"}});

        // atomically increment the invoice cache id
        const std::string invoice_cache_path = std::string(data_base_folder) + "rechnungs_cache.json";
        nlohmann::json invoice_cache{};
        nlohmann::json invoice{};
        {
            std::scoped_lock lock(invoice_file_mutex);
            std::ifstream invoice_cache_file(invoice_cache_path);
            try {
                invoice_cache = nlohmann::json::parse(invoice_cache_file);
                if (!invoice_cache.contains("cur_id"))
                    invoice_cache["cur_id"] = int(1);
            } catch (...) {
                invoice_cache= nlohmann::json{{"cur_id", 0}};
            };
            invoice_cache["cur_id"] = invoice_cache["cur_id"].get<int>() + 1;
            invoice["id"] = invoice_cache["cur_id"].get<int>();
            std::ofstream invoice_cache_out(invoice_cache_path);
            invoice_cache_out << invoice_cache.dump();
        }
        const std::string file_data = invoice.dump();

        set_json(res, data_util::update_file(username, data_base_folder + req.get_header_value("path"), to_bin_span(file_data)));
    });

    // ------------------------------------------------------------------------------------------------
    // Map loading (read only and currently does not need authentication)
    // ------------------------------------------------------------------------------------------------
    app.Get("/heightmap/meta", [](const Request &req, Response &res) {
        // the available tiles are sent as a quadtree coverage {"level/x/y": max_level}: all descendants of the tile down
        // to max_level exist. A tile exists if an ancestor (or the tile itself) is listed with max_level >= its level.
        // The plain tile list has millions of entries (~40 MB json for bavaria) which is too much for mobile browsers
        static const std::string meta = [](){  // single instantiate on first call
            // tile key: level in the upper bits, x and y with 29 bits each
            const auto key = [](uint64_t l, uint64_t x, uint64_t y) { return (l << 58) | (x << 29) | y; };
            std::vector<std::vector<std::pair<uint32_t, uint32_t>>> levels;
            std::unordered_set<uint64_t> tiles;
            if (std::filesystem::exists("data/tiles")) {
                for (const auto& dir_entry: std::filesystem::recursive_directory_iterator("data/tiles")) {
                    if (!dir_entry.is_regular_file() || dir_entry.path().extension() != ".png")
                        continue;
                    // path is data/tiles/level/x/y.png
                    const auto& p = dir_entry.path();
                    try {
                        const uint32_t y = std::stoul(p.stem().string());
                        const uint32_t x = std::stoul(p.parent_path().filename().string());
                        const uint32_t l = std::stoul(p.parent_path().parent_path().filename().string());
                        if (l > 31)
                            continue;
                        if (levels.size() <= l)
                            levels.resize(l + 1);
                        levels[l].emplace_back(x, y);
                        tiles.insert(key(l, x, y));
                    } catch (...) {}
                }
            }
            // deepest level down to which the whole subtree of a tile exists, computed bottom up
            std::unordered_map<uint64_t, uint32_t> full;
            for (int l = int(levels.size()) - 1; l >= 0; --l) {
                for (const auto& [x, y]: levels[l]) {
                    uint32_t depth = l;
                    bool all_children = true;
                    for (uint32_t c = 0; c < 4 && all_children; ++c) {
                        auto it = full.find(key(l + 1, 2 * x + (c & 1), 2 * y + (c >> 1)));
                        if (it == full.end())
                            all_children = false;
                        else
                            depth = c == 0 ? it->second : std::min(depth, it->second);
                    }
                    full[key(l, x, y)] = all_children ? depth : l;
                }
            }
            // top down from the tiles without parent, a tile is listed if its subtree reaches deeper than its listed ancestors
            nlohmann::json coverage = nlohmann::json::object();
            const auto emit = [&](auto&& emit, uint32_t l, uint32_t x, uint32_t y, int reach) -> void {
                auto it = full.find(key(l, x, y));
                if (it == full.end())
                    return;
                if (int(it->second) > reach) {
                    coverage[std::to_string(l) + "/" + std::to_string(x) + "/" + std::to_string(y)] = it->second;
                    reach = it->second;
                }
                for (uint32_t c = 0; c < 4; ++c)
                    emit(emit, l + 1, 2 * x + (c & 1), 2 * y + (c >> 1), reach);
            };
            for (size_t l = 0; l < levels.size(); ++l)
                for (const auto& [x, y]: levels[l])
                    if (l == 0 || !tiles.contains(key(l - 1, x / 2, y / 2)))
                        emit(emit, l, x, y, -1);
            return nlohmann::json{{"coverage", std::move(coverage)}}.dump();
        }();

        res.set_content(meta, "application/json");
    });
    app.Get("/heightmap/(.+)", [](const Request &req, Response &res) {
        const std::string tile = req.matches[1];
        if (tile.find("..") != std::string::npos) {
            res.status = StatusCode::BadRequest_400;
            return set_json(res, {{"error", ".. is not allowed in the path."}});
        }
        std::string filepath = "data/tiles/" + tile + ".png";
        if (!std::filesystem::exists(filepath)) {
            res.status = StatusCode::NotFound_404;
            return set_json(res, {{"error", "The heightmap could not be found"}});
        }

        res.set_file_content(filepath, "image/png");
    });

    // ------------------------------------------------------------------------------------------------
    // File editing
    // ------------------------------------------------------------------------------------------------
    for (const char *route: {"/edit_tbl/(.+)", "/edit_md/(.+)", "/edit_gpx/(.+)"}) {
        app.Get(route, [&](const Request &req, Response &res) {
            std::string username = authorized_user(req, res);

            editor_util::get_editor(res, true, std::string(req.matches[1]), data_base_folder);
        });
    }
    app.Get("/edit_rech/(.+)", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        editor_util::get_editor(res, true, std::string(req.matches[1]), data_base_folder, username);
    });
    app.Get("/edit_gpx", [&](const Request &req, Response &res) {
        editor_util::get_editor(res, false, "test.gpx", data_base_folder);
    });

    // ------------------------------------------------------------------------------------------------
    // General page loading
    // ------------------------------------------------------------------------------------------------
    const std::string overview_page = page_util::load_template("overview.html");
    app.Get("/overview", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        const bool is_admin = username == admin_name;
        res.set_content(page_util::render_page(overview_page, {{"username", is_admin ? std::string("admin") : username}}), "text/html");
    });

    const std::string admin_css = page_util::load_template("admin.css");
    const std::string user_css = page_util::load_template("user.css");
    app.Get("/user_specific.css", [&](const Request &req, Response &res) {
        std::string username = authorized_user(req, res);

        res.set_content(username == admin_name ? admin_css : user_css, "text/css");
    });

    // static files which are loaded once at startup, {route, template file, content type}
    struct static_file { std::string_view route, file, content_type; };
    constexpr std::array static_files{
        static_file{"/admin.css", "admin.css", "text/css"},
        static_file{"/user.css", "user.css", "text/css"},
        static_file{"/md_default.css", "editors/md_default.css", "text/css"},
        static_file{"/drawdown.js", "drawdown.js", "text/javascript"},
        static_file{"/katex.js", "katex.js", "text/javascript"},
        static_file{"/lin_alg.js", "lin_alg.js", "text/javascript"},
        static_file{"/virtual_texture.js", "virtual_texture.js", "text/javascript"},
        static_file{"/gpx_track.js", "gpx_track.js", "text/javascript"},
        static_file{"/vector_tiles.js", "vector_tiles.js", "text/javascript"},
        static_file{"/bayern_3d.js", "bayern_3d.js", "text/javascript"},
        static_file{"/qrcode.min.js", "qrcode.min.js", "text/javascript"},
        static_file{"/tabs/arbeitsplanung.html", "tabs/arbeitsplanung.html", "text/html"},
        static_file{"/tabs/stempeluhr.html", "tabs/stempeluhr.html", "text/html"},
        static_file{"/tabs/daten.html", "tabs/data.html", "text/html"},
        static_file{"/tabs/einstellungen.html", "tabs/einstellungen.html", "text/html"},
    };
    for (const static_file &f: static_files) {
        // the route is used as regex, so the dots have to be escaped
        const std::string route = std::regex_replace(std::string(f.route), std::regex{R"(\.)"}, R"(\.)");
        app.Get(route, [content = page_util::load_template(f.file), content_type = std::string(f.content_type)](const Request &req, Response &res) {
            res.set_content(content, content_type);
        });
    }
    app.Get("/favicon.ico", [](const Request &req, Response &res) {
        res.set_file_content(std::string(page_util::templates_folder) + "server_logo.png", "image/png");
    });

    if (!credentials.contains(std::string{admin_name})){
        LOG_ERROR << "Missing admin credentials, add with the set_password.sh script";
        return -1;
    }

    constexpr int port = 12345;
    LOG_INFO << "Starting server on port " << port;
    if (!app.listen("0.0.0.0", port)) {
        LOG_ERROR << "Could not start the server on port " << port;
        return -1;
    }
    return 0;
}
